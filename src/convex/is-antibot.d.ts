/**
 * Minimal type declaration for `is-antibot` (microlinkhq) — the package
 * ships plain CJS with no bundled types. Only the surface PureWire uses is
 * declared here; the underlying API accepts any fetch-like response.
 */
declare module "is-antibot" {
  export interface AntibotResult {
    detected: boolean;
    provider: string | null;
    detection: string | null;
  }

  export interface AntibotInput {
    headers: Headers | Record<string, string | undefined>;
    statusCode: number;
    html: string;
    url: string;
  }

  export default function isAntibot(input: AntibotInput): AntibotResult;
}
