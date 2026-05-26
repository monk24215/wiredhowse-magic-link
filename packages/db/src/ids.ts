import { nanoid } from 'nanoid';

export const makeId = {
  siteOwner: () => `so_${nanoid(12)}`,
  site: () => `st_${nanoid(12)}`,
  endUser: () => `eu_${nanoid(12)}`,
  session: () => `sess_${nanoid(12)}`,
  magicLink: () => `ml_${nanoid(12)}`,
  handoffToken: () => `ho_${nanoid(12)}`,
  siteOwnerSession: () => `dsess_${nanoid(12)}`,
  emailVerification: () => `ev_${nanoid(12)}`,
  passwordReset: () => `pr_${nanoid(12)}`,
  oauthState: () => `os_${nanoid(12)}`,
} as const;
