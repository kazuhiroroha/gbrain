import type { ReflexPointer } from './retrieval-reflex.ts';

export interface ShadowObservation {
  readonly schema: 'gbrain-shadow-observation/v1';
  readonly state: 'shadow' | 'switched';
  readonly primarySource: string;
  readonly shadowSource: string;
  readonly slugs: readonly string[];
}

export type ShadowObservationSink = (observation: ShadowObservation) => void;

const SAFE_SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_SLUG = /^[a-z0-9][a-z0-9._/-]{0,255}$/;
const MAX_SLUGS = 20;

export function safeSourceQualifiedSlugs(pointers: readonly ReflexPointer[]): readonly string[] {
  const safe = new Set<string>();
  for (const pointer of pointers) {
    if (!SAFE_SOURCE_ID.test(pointer.source_id) || !SAFE_SLUG.test(pointer.slug) || pointer.slug.includes('//')) continue;
    if (pointer.slug.split('/').some((part) => part === '.' || part === '..')) continue;
    safe.add(`${pointer.source_id}:${pointer.slug}`);
  }
  return Object.freeze([...safe].sort().slice(0, MAX_SLUGS));
}

export function buildShadowObservation(params: {
  state: 'shadow' | 'switched';
  primarySource: string;
  shadowSource: string;
  pointers: readonly ReflexPointer[];
}): ShadowObservation {
  if (!SAFE_SOURCE_ID.test(params.shadowSource)) {
    throw new TypeError('invalid shadow source');
  }
  return Object.freeze({
    schema: 'gbrain-shadow-observation/v1',
    state: params.state,
    primarySource: params.primarySource,
    shadowSource: params.shadowSource,
    slugs: safeSourceQualifiedSlugs(
      params.pointers.filter((pointer) => pointer.source_id === params.shadowSource),
    ),
  });
}
