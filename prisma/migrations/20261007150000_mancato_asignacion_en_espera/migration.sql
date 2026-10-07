-- El estado "sin servicio" pasa a llamarse "en espera": el peaje espera a que la oficina cargue el servicio.
ALTER TYPE "MancatoAsignacion" RENAME VALUE 'SIN_SERVICIO' TO 'EN_ESPERA';
