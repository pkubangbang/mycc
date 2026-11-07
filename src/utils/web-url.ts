/** Shared HTTP(S)-only target validation for every web-fetch caller. */
export function validateWebFetchUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Error: Invalid URL format. Please provide a valid URL starting with http:// or https://';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Error: Unsupported URL protocol "${parsed.protocol}". Only http:// and https:// are supported.`;
  }
  return null;
}
