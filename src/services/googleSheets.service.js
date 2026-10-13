import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AppError } from "../utils/AppError.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_PATH = path.join(__dirname, "../../config/google-service-account.json");
const KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH || DEFAULT_KEY_PATH;

// "APP GT 1.0", la planilla que respalda la app de AppSheet que se esta reemplazando.
// Tiene ~59 pestanas (registros, choferes, vehiculos, sueldos, agenda, etc.), asi que
// se referencian por nombre exacto en vez de buscarlas dinamicamente - recorrer las 59
// pestanas en cada sync es lento y ademas varias comparten nombres de columna (ej.
// "Id_Trabajador" aparece en la tabla de choferes Y en una de seguimiento semanal).
export const APPSHEET_SPREADSHEET_ID =
  process.env.APPSHEET_SPREADSHEET_ID || "1ZSNMIT69FJbkV9rsMjFJte8nddqDpSzPS0WG1FXG3hQ";

let sheetsClientPromise = null;

// googleapis pesa ~80 MB de memoria apenas se carga y la sincronizacion con la planilla se usa muy de vez en cuando: se carga recien
// la primera vez que hace falta (no al arrancar el servidor, donde ocupaba memoria de la instancia de 512 MB sin usarse).
const getSheetsClient = () => {
  if (!sheetsClientPromise) {
    if (!fs.existsSync(KEY_PATH)) {
      throw new AppError(
        `No se encontro la credencial de Google Sheets en ${KEY_PATH}. Falta configurar el Service Account.`,
        500
      );
    }
    sheetsClientPromise = import("googleapis")
      .then(async ({ google }) => {
        const auth = new google.auth.GoogleAuth({
          keyFile: KEY_PATH,
          // Antes solo lectura - se necesita el scope completo para poder escribir de
          // vuelta a la hoja (ver appendSheetRow / appsheetWriteback.service.js). El
          // service account tambien necesita estar compartido como Editor en la planilla
          // (esto es en Google Sheets, no alcanza con el scope del lado del codigo).
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        const authClient = await auth.getClient();
        return google.sheets({ version: "v4", auth: authClient });
      })
      .catch((err) => {
        // Si falla (credencial invalida, red), el proximo intento vuelve a probar en vez de quedar con el error guardado.
        sheetsClientPromise = null;
        throw err;
      });
  }
  return sheetsClientPromise;
};

// Devuelve { header, rows } de una pestana por su nombre exacto. Algunas pestanas
// (ej. "Hoja 1", "Hoja 2") tienen una primera fila en blanco antes del header real -
// se salta cualquier fila vacia inicial en vez de asumir que el header esta en la fila 1.
export const fetchSheetRowsByTabName = async (tabName, lastColumn = "AZ") => {
  const sheets = await getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: APPSHEET_SPREADSHEET_ID,
    range: `'${tabName}'!A:${lastColumn}`,
  });
  const values = data.values ?? [];
  const headerIndex = values.findIndex((row) => row.length > 0);
  if (headerIndex === -1) {
    throw new AppError(`La pestana "${tabName}" esta vacia en la planilla de AppSheet.`, 500);
  }
  const [header, ...rows] = values.slice(headerIndex);
  return { header, rows };
};

// Solo el header de una pestana (primeras filas, no toda la pestana) - para saber en
// que orden van las columnas al escribir sin tener que traer miles de filas nada mas
// para eso. Mismo criterio que fetchSheetRowsByTabName para saltear una fila en blanco
// inicial.
export const fetchSheetHeader = async (tabName) => {
  const sheets = await getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: APPSHEET_SPREADSHEET_ID,
    range: `'${tabName}'!A1:AZ5`,
  });
  const values = data.values ?? [];
  const header = values.find((row) => row.length > 0);
  if (!header) {
    throw new AppError(`La pestana "${tabName}" esta vacia en la planilla de AppSheet.`, 500);
  }
  return header;
};

// Ubica la fila (numero absoluto 1-indexado en la hoja) donde una columna dada tiene
// cierto valor - por ejemplo, encontrar la fila de "ID" para poder corregir una sola
// celda de un registro existente (backfill puntual) sin tocar el resto de la fila.
export const findRowNumberByColumnValue = async (tabName, columnName, value) => {
  const sheets = await getSheetsClient();
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: APPSHEET_SPREADSHEET_ID,
    range: `'${tabName}'!A:AZ`,
  });
  const values = data.values ?? [];
  const headerIndex = values.findIndex((row) => row.length > 0);
  if (headerIndex === -1) return null;
  const colIndex = values[headerIndex].findIndex((h) => h.trim() === columnName);
  if (colIndex === -1) return null;
  for (let i = headerIndex + 1; i < values.length; i += 1) {
    if ((values[i][colIndex] ?? "").trim() === String(value)) {
      return i + 1;
    }
  }
  return null;
};

const columnIndexToLetter = (index) => {
  let letter = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
};

// Borra una fila entera (identificada por numero de fila absoluto, ver
// findRowNumberByColumnValue) - las filas de abajo se corren hacia arriba, como
// borrar una fila a mano en Sheets. No se usa values.clear: eso dejaria una fila en
// blanco en el medio en vez de sacarla, y AppSheet seguiria contandola.
export const deleteSheetRow = async (tabName, rowNumber) => {
  const sheets = await getSheetsClient();
  const meta = await sheets.spreadsheets.get({
    spreadsheetId: APPSHEET_SPREADSHEET_ID,
    fields: "sheets.properties",
  });
  const properties = meta.data.sheets.find((s) => s.properties.title === tabName)?.properties;
  if (!properties) {
    throw new AppError(`No se encontro la pestana "${tabName}" en la planilla de AppSheet.`, 500);
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: APPSHEET_SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: properties.sheetId,
              dimension: "ROWS",
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        },
      ],
    },
  });
};

// Corrige una unica celda de una fila ya existente (identificada por numero de fila
// absoluto, ver findRowNumberByColumnValue), en vez de reescribir la fila entera.
export const updateSheetCell = async (tabName, rowNumber, columnName, value) => {
  const header = await fetchSheetHeader(tabName);
  const colIndex = header.findIndex((h) => h.trim() === columnName);
  if (colIndex === -1) {
    throw new AppError(`La columna "${columnName}" no existe en "${tabName}".`, 500);
  }
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: APPSHEET_SPREADSHEET_ID,
    range: `'${tabName}'!${columnIndexToLetter(colIndex)}${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  });
};

// Corrige una fila ya existente (identificada por numero de fila absoluto, ver
// findRowNumberByColumnValue) con varias columnas a la vez. A diferencia de
// appendSheetRow, esto NO pisa con "" las columnas que no vienen en valuesByHeader -
// se conserva lo que ya estaba en esa celda (ej. "AUTOSTRADA", "TURNO", cargadas a
// mano en AppSheet y sin campo propio en Record) para no perder datos ajenos a esta
// actualizacion puntual.
export const updateSheetRow = async (tabName, rowNumber, valuesByHeader) => {
  const sheets = await getSheetsClient();
  const [header, existingRow] = await Promise.all([
    fetchSheetHeader(tabName),
    sheets.spreadsheets.values
      .get({ spreadsheetId: APPSHEET_SPREADSHEET_ID, range: `'${tabName}'!A${rowNumber}:AZ${rowNumber}` })
      .then((res) => res.data.values?.[0] ?? []),
  ]);

  const row = header.map((columnName, i) => {
    const key = columnName.trim();
    return key in valuesByHeader ? valuesByHeader[key] : (existingRow[i] ?? "");
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: APPSHEET_SPREADSHEET_ID,
    range: `'${tabName}'!A${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
};

// Agrega una fila al final de una pestana. valuesByHeader: { "NOMBRE COLUMNA": valor }
// - se arma en el orden real de columnas de la hoja (pidiendo el header actual), asi
// que una columna que todavia no existe ahi (ej. "ZONA" antes de agregarla) se ignora
// en vez de romper, y si se reordenan columnas esto sigue escribiendo en el lugar
// correcto. valueInputOption "USER_ENTERED" para que Sheets parsee fecha/numero igual
// que si lo tipeara una persona (o AppSheet), no como texto literal.
//
// OJO: no usa sheets.spreadsheets.values.append. Esa API "detecta la tabla" recorriendo
// desde arriba y se detiene en la primera fila completamente vacia que encuentra - en
// "DHL CONSEGNAS" (6000+ filas historicas) hay al menos un hueco en el medio, asi que
// append terminaba insertando ahi en vez de al final real (se detecto y se revirtio a
// mano una vez). En cambio, se pide la pestana entera (A:AZ) y se escribe con
// values.update directo en la primera fila realmente vacia (values.length + 1: la API
// de Sheets solo omite filas vacias al FINAL del rango, no las del medio, asi que este
// numero es confiable) - mas lento que append, pero no tiene ese problema.
export const appendSheetRow = async (tabName, valuesByHeader) => {
  const sheets = await getSheetsClient();
  // Ancho completo (A:AZ), no solo la columna ID: el sync salta filas sin ID (ver
  // appsheetSync.service.js), lo que confirma que puede haber filas con datos en otras
  // columnas pero ID vacio - mirar solo A subestimaria la ultima fila real.
  const [header, allValues, meta] = await Promise.all([
    fetchSheetHeader(tabName),
    sheets.spreadsheets.values
      .get({ spreadsheetId: APPSHEET_SPREADSHEET_ID, range: `'${tabName}'!A:AZ` })
      .then((res) => res.data.values ?? []),
    sheets.spreadsheets.get({ spreadsheetId: APPSHEET_SPREADSHEET_ID, fields: "sheets.properties" }),
  ]);
  const properties = meta.data.sheets.find((s) => s.properties.title === tabName)?.properties;
  if (!properties) {
    throw new AppError(`No se encontro la pestana "${tabName}" en la planilla de AppSheet.`, 500);
  }

  const nextRow = allValues.length + 1;
  // .trim(): al menos una columna real de la hoja ("PRECIO ATTESA ") tiene un espacio
  // colgando al final que no se nota mirandola (paso desapercibido una vez, con ese
  // valor sin escribirse por el mismatch) - las claves de valuesByHeader se pasan
  // limpias, asi que hay que limpiar el nombre real de la hoja para que matcheen.
  const row = header.map((columnName) => valuesByHeader[columnName.trim()] ?? "");

  // Si la grilla termina justo donde termina el dato (sin filas de sobra al final,
  // como quedo esta pestana despues de borrar una fila de prueba a mano), values.update
  // no la agranda solo - hay que agregarle fila(s) antes de poder escribir ahi.
  if (nextRow > properties.gridProperties.rowCount) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: APPSHEET_SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            appendDimension: {
              sheetId: properties.sheetId,
              dimension: "ROWS",
              length: nextRow - properties.gridProperties.rowCount,
            },
          },
        ],
      },
    });
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: APPSHEET_SPREADSHEET_ID,
    range: `'${tabName}'!A${nextRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });
};
