import {
  DataSourceInstanceSettings,
  DataQueryResponse,
  DataFrame,
  LoadingState,
  DataQueryRequest,
  MetricFindValue,
  ScopedVars,
} from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv } from '@grafana/runtime';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { TimestreamQuery, TimestreamOptions, TimestreamCustomMeta, MeasureInfo, DataType } from './types';
import { keepChecking } from 'looper';

export class DataSource extends DataSourceWithBackend<TimestreamQuery, TimestreamOptions> {
  // Easy access for QueryEditor
  options: TimestreamOptions;

  constructor(instanceSettings: DataSourceInstanceSettings<TimestreamOptions>) {
    super(instanceSettings);
    this.options = instanceSettings.jsonData;
  }

  async metricFindQuery(query: any, options?: any): Promise<MetricFindValue[]> {
    if (!query) {
      return Promise.resolve([]);
    }
    const q = getTemplateSrv().replace(query as string);
    console.log('metricFindQuery', q);
    return this.getStrings(q)
      .toPromise()
      .then(strings => {
        return strings.map(s => ({
          text: s,
        }));
      });
  }

  getQueryDisplayText(query: TimestreamQuery): string {
    return query.rawQuery ?? '';
  }

  applyTemplateVariables(query: TimestreamQuery, scopedVars: ScopedVars): TimestreamQuery {
    if (!query.rawQuery) {
      return query;
    }

    const templateSrv = getTemplateSrv();
    return {
      ...query,
      database: templateSrv.replace(query.database || '', scopedVars),
      table: templateSrv.replace(query.table || '', scopedVars),
      measure: templateSrv.replace(query.measure || '', scopedVars),
      rawQuery: templateSrv.replace(query.rawQuery), // DO NOT include scopedVars! it uses $__interval_ms!!!!!
    };
  }

  query(request: DataQueryRequest<TimestreamQuery>): Observable<DataQueryResponse> {
    let queryId: string | undefined;
    let obs: Observable<DataQueryResponse> | undefined;
    return new Observable<DataQueryResponse>(subscriber => {
      obs = super.query(request);
      obs.toPromise().then(rsp => {
        const meta = getNextTokenMeta(rsp);
        if (meta) {
          queryId = meta.queryId;
          rsp.state = LoadingState.Loading; // streaming?
          if (!meta.hasSeries) {
            rsp.key = meta.queryId;
          }
          keepChecking({
            subscriber,
            req: request,
            rsp,
            count: 1,
            ds: this,
          });
        }
        subscriber.next(rsp);
        if (!meta) {
          subscriber.complete(); // done
        }
      });

      return () => {
        console.log('unsubscribe.. timestream cancel? ', queryId);
      };
    });
  }

  //----------------------------------------------
  // SCHEMA Style Functions
  //----------------------------------------------

  private getStrings(rawQuery: string): Observable<string[]> {
    return this.query(({
      targets: [
        {
          refId: 'X',
          rawQuery,
        },
      ],
    } as unknown) as DataQueryRequest).pipe(
      map(res => {
        const first = res.data[0] as DataFrame;
        const vals = first.fields[0]?.values;
        if (vals) {
          return vals.toArray(); //
        }
        return [];
      })
    );
  }

  async getDatabases(like?: string): Promise<string[]> {
    return this.getStrings('SHOW DATABASES').toPromise();
  }

  async getTables(db: string): Promise<string[]> {
    if (!db) {
      return [];
    }
    return this.getStrings(`SHOW TABLES FROM ${db}`).toPromise();
  }

  async getMeasureInfo(db: string, table: string): Promise<MeasureInfo[]> {
    if (!db || !table) {
      return [];
    }
    return this.query(({
      targets: [
        {
          refId: 'X',
          rawQuery: `SHOW MEASURES FROM ${db}.${table}`,
        },
      ],
    } as unknown) as DataQueryRequest)
      .toPromise()
      .then(res => {
        const rsp: MeasureInfo[] = [];
        const first = res.data[0] as DataFrame;
        if (!first || !first.length) {
          return rsp;
        }
        const name = first.fields[0]?.values;
        const type = first.fields[1]?.values;
        const dims = first.fields[2]?.values;

        for (let i = 0; i < first.length; i++) {
          const dimensions = (JSON.parse(dims.get(i)) as any[]).map(row => {
            return row.dimension_name;
          });
          rsp.push({
            name: name.get(i) as string,
            type: type.get(i) as DataType,
            dimensions,
          });
        }
        return rsp;
      });
  }
}

export function getNextTokenMeta(rsp: DataQueryResponse): TimestreamCustomMeta | undefined {
  if (rsp.data?.length) {
    const first = rsp.data[0] as DataFrame;
    const meta = first.meta?.custom as TimestreamCustomMeta;
    if (meta && meta.nextToken) {
      return meta;
    }
  }
  return undefined;
}
