import type { ReactNode } from "react";
import { getProviderIconData } from "@/components/icons";
import { cn } from "@/lib/utils";

const SVG_TAG_REGEX = /<(path|circle|rect)\s+([^>]+?)\/>/g;
const SVG_ATTR_REGEX = /([a-z-]+)="([^"]*)"/g;

export function ProviderMark({
  className,
  providerID,
  providerName,
}: {
  className?: string;
  providerID?: string;
  providerName?: string;
}) {
  const icon = getProviderIconData(providerID, providerName);

  if (icon) {
    return (
      <svg
        aria-hidden="true"
        className={cn("size-4", className)}
        fill="currentColor"
        viewBox={icon.viewBox}
      >
        {renderIconBody(icon.body)}
      </svg>
    );
  }

  return null;
}

function renderIconBody(body: string) {
  const nodes: ReactNode[] = [];
  let match: RegExpExecArray | null = SVG_TAG_REGEX.exec(body);
  let index = 0;

  while (match) {
    const tag = match[1];
    const attrs = parseSvgAttributes(match[2] ?? "");

    if (tag === "path") {
      nodes.push(<path key={`path-${index}`} {...attrs} />);
    } else if (tag === "circle") {
      nodes.push(<circle key={`circle-${index}`} {...attrs} />);
    } else if (tag === "rect") {
      nodes.push(<rect key={`rect-${index}`} {...attrs} />);
    }

    index += 1;
    match = SVG_TAG_REGEX.exec(body);
  }

  SVG_TAG_REGEX.lastIndex = 0;
  return nodes;
}

function parseSvgAttributes(raw: string) {
  const props: Record<string, string> = {};
  let match: RegExpExecArray | null = SVG_ATTR_REGEX.exec(raw);

  while (match) {
    const key = match[1];
    const value = match[2];
    if (key && value !== undefined) {
      props[toSvgPropName(key)] = value;
    }
    match = SVG_ATTR_REGEX.exec(raw);
  }

  SVG_ATTR_REGEX.lastIndex = 0;
  return props;
}

function toSvgPropName(attribute: string) {
  if (attribute === "stroke-linecap") {
    return "strokeLinecap";
  }

  if (attribute === "stroke-linejoin") {
    return "strokeLinejoin";
  }

  if (attribute === "stroke-width") {
    return "strokeWidth";
  }

  if (attribute === "fill-rule") {
    return "fillRule";
  }

  if (attribute === "clip-rule") {
    return "clipRule";
  }

  return attribute;
}
