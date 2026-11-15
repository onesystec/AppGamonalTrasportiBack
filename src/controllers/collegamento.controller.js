import {
  accettaCollegamento,
  reinviaSolicitud,
  riceviAnnullo,
  riceviRichiesta,
  riceviScollega,
  riceviServizio,
  rifiutaCollegamento,
  rigeneraCodice,
  scollega,
  statoCollegamenti,
} from "../services/collegamento.service.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data });

// Oficina
export const stato = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  ok(res, await statoCollegamenti(req));
});
export const rigenera = asyncHandler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  ok(res, await rigeneraCodice(req));
});
export const accetta = asyncHandler(async (req, res) => ok(res, { collegamento: await accettaCollegamento(req.user, req.params.id, req.body) }));
export const rifiuta = asyncHandler(async (req, res) => {
  await rifiutaCollegamento(req.user, req.params.id);
  res.status(204).send();
});
export const elimina = asyncHandler(async (req, res) => {
  await scollega(req.user, req.params.id);
  res.status(204).send();
});
export const reinvia = asyncHandler(async (req, res) => ok(res, await reinviaSolicitud(req.params.id)));

// API publica (la llama la otra app: sin sesion, por token)
export const pubRichiesta = asyncHandler(async (req, res) => ok(res, await riceviRichiesta(req.body), 201));
export const pubScollega = asyncHandler(async (req, res) => ok(res, await riceviScollega(req.collegamento)));
export const pubServizio = asyncHandler(async (req, res) => ok(res, await riceviServizio(req.collegamento, req.body)));
export const pubAnnullo = asyncHandler(async (req, res) => ok(res, await riceviAnnullo(req.collegamento, req.params.recordId, req.body)));
