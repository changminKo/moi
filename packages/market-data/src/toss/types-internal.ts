export type FetchLike = (
  input: URL | string,
  init?: RequestInit,
) => Promise<Response>;
