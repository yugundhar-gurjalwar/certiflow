export type Role = "centre" | "district_officer" | "quality" | "state";

/** The authenticated caller. Built ONLY from the verified token + a fresh DB lookup, never from request bodies. */
export interface Actor {
  id: string;
  name: string;
  role: Role;
  centreId: string | null;
  districtId: string | null;
}

export const SYSTEM_ACTOR = (component: string) => ({
  id: null as string | null,
  name: `system:${component}`,
  role: "system" as const,
});
export type AuditActor = Actor | ReturnType<typeof SYSTEM_ACTOR>;
