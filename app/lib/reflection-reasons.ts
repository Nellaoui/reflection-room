// Plain-language categories from the Casablanca Behaviour Policy's
// teacher-managed incidents. Safeguarding referrals use the school process.
export const reflectionReasonOptions = [
  { value: "disruption", label: "Disruption in class" },
  { value: "instructions", label: "Not following instructions" },
  { value: "disrespect", label: "Disrespectful behaviour" },
  { value: "language", label: "Inappropriate language or name-calling" },
  { value: "physical-contact", label: "Minor inappropriate physical contact" },
  { value: "device-use", label: "Misuse of devices" },
  { value: "other", label: "Other" },
] as const;

export function formatReflectionReason(value: string, details: string): string | null {
  const option = reflectionReasonOptions.find(reason => reason.value === value);
  if (!option) return null;
  if (option.value === "other") return details ? `Other: ${details}` : null;
  return option.label;
}

export function reflectionReasonCategory(reason: string): string {
  if (reason.startsWith("Other: ")) return "Other";
  return reflectionReasonOptions.find(option => option.label === reason)?.label ?? "Previous reasons";
}
