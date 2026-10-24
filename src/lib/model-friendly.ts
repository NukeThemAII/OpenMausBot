import { t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";

const BLURBS: readonly [RegExp, LocaleKey][] = [
  [/opus/, "model.blurb.smartest"],
  [/sonnet/, "model.blurb.balanced"],
  [/haiku/, "model.blurb.fastest"],
  [/\b(mini|nano|flash|lite)\b|-(mini|nano|flash|lite)\b/, "model.blurb.light"],
];

export function modelBlurb(option: { id: string; label: string }): string | undefined {
  const name = `${option.id} ${option.label}`.toLowerCase();
  const match = BLURBS.find(([pattern]) => pattern.test(name));
  return match ? t(match[1]) : undefined;
}
