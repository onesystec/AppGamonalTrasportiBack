-- Solicitudes registradas pegando solo el texto: si el texto no trae la ETA, la solicitud se guarda igual (con la fecha de hoy como valor de relleno, porque
-- fechaHora es obligatoria) y se marca aqui para que la hoja la pinte en rojo hasta que alguien escriba la ETA real.
ALTER TABLE "solicitudes_servicio" ADD COLUMN "etaPendiente" BOOLEAN NOT NULL DEFAULT false;
