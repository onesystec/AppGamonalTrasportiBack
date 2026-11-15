import assert from "node:assert/strict";
import { test } from "node:test";
import { CodiceNonValido, formatoCodice, leggiCodice } from "../src/utils/codiceCollegamento.js";

test("codice di collegamento: andata e ritorno con https sottinteso", () => {
  const codice = formatoCodice("AB12-CD34", "https://lombardi-api.onrender.com");
  assert.equal(codice, "AB12-CD34@lombardi-api.onrender.com");
  assert.deepEqual(leggiCodice(codice), { segreto: "AB12-CD34", url: "https://lombardi-api.onrender.com" });
});

test("codice di collegamento: minuscole, spazi, / finale e /api si normalizzano", () => {
  assert.deepEqual(leggiCodice("  ab12-cd34@lombardi-api.onrender.com/api/ "), { segreto: "AB12-CD34", url: "https://lombardi-api.onrender.com" });
});

test("codice di collegamento: in produzione niente http ne' indirizzi privati", () => {
  assert.throws(() => leggiCodice("AB12-CD34@http://lombardi.it"), CodiceNonValido);
  assert.throws(() => leggiCodice("AB12-CD34@localhost:4000"), CodiceNonValido);
  assert.throws(() => leggiCodice("AB12-CD34@192.168.1.10"), CodiceNonValido);
  assert.deepEqual(leggiCodice("AB12-CD34@http://localhost:4002", { produzione: false }), { segreto: "AB12-CD34", url: "http://localhost:4002" });
});

test("codice di collegamento: forma sbagliata", () => {
  assert.throws(() => leggiCodice("lombardi.it"), CodiceNonValido);
  assert.throws(() => leggiCodice("ABC@lombardi.it"), CodiceNonValido);
  assert.throws(() => leggiCodice(""), CodiceNonValido);
});
test("url della richiesta: stesse regole", async () => { const { urlValida } = await import("../src/utils/codiceCollegamento.js"); assert.equal(urlValida("https://a.it/"), "https://a.it"); assert.throws(() => urlValida("http://10.0.0.1"), CodiceNonValido); });

test("host privati: IPv4 riservati, IPv6 e IPv4 mappato in IPv6", async () => {
  const { hostPrivato } = await import("../src/utils/codiceCollegamento.js");
  for (const h of ["localhost", "app.localhost", "intranet", "x.internal", "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.5", "100.64.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "198.18.0.1", "224.0.0.1", "[::1]", "::", "[fc00::1]", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "[::ffff:7f00:1]", "::ffff:10.0.0.1", ""])
    assert.equal(hostPrivato(h), true, h);
  for (const h of ["gamonal-api.onrender.com", "8.8.8.8", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.equal(hostPrivato(h), false, h);
});

test("codice: in produzione rifiuta IP in forma alternativa, credenziali nell'URL e host fuori dalla lista", () => {
  assert.throws(() => leggiCodice("AB12-CD34@[::1]"), CodiceNonValido);
  assert.throws(() => leggiCodice("AB12-CD34@[::ffff:127.0.0.1]"), CodiceNonValido);
  assert.throws(() => leggiCodice("AB12-CD34@2130706433"), CodiceNonValido); // 127.0.0.1 in decimale
  assert.throws(() => leggiCodice("AB12-CD34@0x7f.1"), CodiceNonValido);
  assert.throws(() => leggiCodice("AB12-CD34@utente:clave@gamonal.onrender.com"), CodiceNonValido);
  const permessi = { hostPermessi: ["gamonal.onrender.com"] };
  assert.equal(leggiCodice("AB12-CD34@gamonal.onrender.com", permessi).url, "https://gamonal.onrender.com");
  assert.throws(() => leggiCodice("AB12-CD34@altra-app.onrender.com", permessi), CodiceNonValido);
  assert.throws(() => leggiCodice("AB12-CD34@gamonal.onrender.com.altra.it", permessi), CodiceNonValido);
  // In sviluppo la lista non si applica.
  assert.equal(leggiCodice("AB12-CD34@http://localhost:4002", { produzione: false, ...permessi }).url, "http://localhost:4002");
});

test("codice: scade dopo le ore indicate e senza data si considera scaduto", async () => {
  const { codiceScaduto } = await import("../src/utils/codiceCollegamento.js");
  const ora = Date.parse("2026-11-15T12:00:00Z");
  assert.equal(codiceScaduto("2026-11-15T00:00:00Z", { ora }), false);
  assert.equal(codiceScaduto("2026-11-14T11:59:00Z", { ora }), true);
  assert.equal(codiceScaduto(undefined, { ora }), true);
  assert.equal(codiceScaduto("2026-11-20T00:00:00Z", { ora }), true); // data nel futuro: non valida
});
