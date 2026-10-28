-- La casilla del perfil pasa a ser un interruptor de Pago a choferes y ya no cambia el importe: solo decide si el trabajo fuera de horario y la
-- reperibilita se muestran y pagan APARTE del basico (true: Jesus y Luis) o todo junto en un solo total (false: el resto).
ALTER TABLE "users" RENAME COLUMN "pagaFueraHorario" TO "pagoAparte";
