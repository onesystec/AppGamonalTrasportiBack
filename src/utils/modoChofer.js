export const canUseDriverMode = (cargo) => ["OWNER", "ADMIN", "RRHH"].includes(cargo);
export const isDriverMode = (req, user) => req.headers["x-modo-chofer"] === "1" && canUseDriverMode(user.cargo);
