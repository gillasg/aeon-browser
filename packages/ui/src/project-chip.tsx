import { useEffect, useState, type ReactElement } from "react";
import { requestProject } from "./project-requests.js";
export function ProjectChip(props: {
  name?: string | null | undefined;
  projectId?: string | null | undefined;
}): ReactElement | null {
  const [name, setName] = useState<string | null>(null);
  const id = props.projectId ?? new URLSearchParams(location.search).get("projectId");
  useEffect(() => {
    if (!id) return;
    let active = true;
    void requestProject("project.list")
      .then((result) => {
        if (active)
          setName(result.projects?.find((project) => project.projectId === id)?.name ?? null);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);
  const label = props.name ?? name;
  if (!label) return null;
  return (
    <div className="home-project-chip">
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <path d="M3 7h18v13H3zM3 7V4h7l3 3" />
      </svg>
      <span>{label}</span>
    </div>
  );
}
