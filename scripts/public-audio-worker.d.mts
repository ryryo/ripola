interface StaticAssets { fetch(request: Request): Promise<Response> }
declare const worker: { fetch(request: Request, env: { ASSETS: StaticAssets }): Promise<Response> };
export default worker;
