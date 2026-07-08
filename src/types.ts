export const CATEGORY_NAMES = [
  "auth",
  "payments",
  "infra",
  "frontend",
  "backend",
  "data",
  "testing",
  "ai-workflow",
  "docs",
  "other",
] as const;

export type CategoryName = (typeof CATEGORY_NAMES)[number];

export interface RepoInfo {
  host_type: "github" | "gitlab" | "bitbucket" | "other" | "none";
  age_days: number;
  repo_fingerprint: string;
}

export interface IdentityInfo {
  author_identity_hashes: string[];
  other_contributors_count: number;
}

export interface CommitsInfo {
  user_total: number;
  first_at: string;
  last_at: string;
  span_days: number;
  hour_histogram: number[];
  weekday_histogram: number[];
}

export interface SignedInfo {
  count: number;
  ratio: number;
}

export interface LanguageShare {
  extension: string;
  share: number;
}

export interface CategoryShare {
  name: CategoryName;
  commit_count: number;
  churn_share: number;
}

export interface DetectedSkill {
  slug: string;
  commit_count: number;
  first_seen: string;
  last_seen: string;
}

export interface OwnershipInfo {
  user_commit_ratio: number;
}

export interface IntegrityInfo {
  merkle_root: string;
  algorithm: "sha256";
}

export interface AttestationInfo {
  authorized_confirmation: true;
  confirmed_at: string;
}

export interface Bundle {
  schema_version: "1.0.0";
  runner: "local" | "ci";
  tool_version: string;
  created_at: string;
  repo: RepoInfo;
  identity: IdentityInfo;
  commits: CommitsInfo;
  signed: SignedInfo;
  languages: LanguageShare[];
  categories: CategoryShare[];
  detected_skills: DetectedSkill[];
  ownership: OwnershipInfo;
  integrity: IntegrityInfo;
  attestation: AttestationInfo;
}
