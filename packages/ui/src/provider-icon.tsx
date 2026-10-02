import { useEffect, useState, type ReactElement } from "react";

type Catalog = Record<string, { models?: Record<string, { canonical_model_id?: string }> }>;
let catalogPromise: Promise<Catalog> | undefined;
function catalog(): Promise<Catalog> {
  catalogPromise ??= fetch("https://models.dev/api.json")
    .then((response) => {
      if (!response.ok) throw new Error("Model logo catalog unavailable");
      return response.json() as Promise<Catalog>;
    })
    .catch(() => ({}));
  return catalogPromise;
}

// Resolve the originating model lab from public metadata; hosting providers are the fallback.
export function ProviderIcon({
  provider,
  modelId,
}: {
  provider: string;
  modelId?: string | undefined;
}): ReactElement {
  const [origin, setOrigin] = useState(provider);
  useEffect(() => {
    let mounted = true;
    setOrigin(provider);
    if (modelId)
      void catalog().then((data) => {
        const key =
          Object.keys(data).find((candidate) => candidate === provider) ??
          Object.keys(data).find(
            (candidate) =>
              provider.startsWith(candidate + "-") || candidate.startsWith(provider + "-"),
          ) ??
          provider;
        const canonical = data[key]?.models?.[modelId]?.canonical_model_id;
        if (mounted) setOrigin(canonical?.split("/")[0] ?? key);
      });
    return () => {
      mounted = false;
    };
  }, [provider, modelId]);
  return (
    <span
      className="provider-icon"
      aria-hidden="true"
      style={{
        maskImage: `url("https://models.dev/logos/${encodeURIComponent(origin)}.svg")`,
        WebkitMaskImage: `url("https://models.dev/logos/${encodeURIComponent(origin)}.svg")`,
      }}
    />
  );
}
