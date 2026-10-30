import { z } from "zod";

export const usosQuerySchema = z.object({
  desde: z.coerce.date({ errorMap: () => ({ message: "desde invalida" }) }),
  hasta: z.coerce.date({ errorMap: () => ({ message: "hasta invalida" }) }),
});
