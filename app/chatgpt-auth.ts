// Shared profile shape retained for the existing membership types.
// Vercel runtime identities are resolved exclusively from verified Google sessions.
export type ChatGPTUser = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};
