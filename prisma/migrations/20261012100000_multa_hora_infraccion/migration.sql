-- Hora (HH:MM, Roma) de la infraccion, cuando el verbale la dice: sirve para encontrar el servicio en curso a esa hora.
ALTER TABLE "multas" ADD COLUMN "horaInfraccion" VARCHAR(5);
