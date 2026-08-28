declare module 'virtual:solid-ssr-handler' {
  /** Maps a web Request to the streamed SSR Response. */
  export function handleRequest(request: Request): Promise<Response>;
  const handler: { fetch(request: Request): Promise<Response> };
  export default handler;
}
