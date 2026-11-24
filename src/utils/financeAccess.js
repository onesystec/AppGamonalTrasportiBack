export const FINANCE_ROLES = ["OWNER", "ADMIN", "RRHH"];

export const canManageFinance = (actor) => FINANCE_ROLES.includes(actor.cargo);
