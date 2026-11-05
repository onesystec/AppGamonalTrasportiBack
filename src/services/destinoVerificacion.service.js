import { PAISES, capCoincideConPais, normCap } from "../constants/paises.js";
import { geocodeComponents } from "./geocoding.service.js";

// Comprobacion de la direccion de entrega leida de un texto (DHL / AB Service) con DOS datos que se confirman entre si: el pais y el CAP.
//  1. Formato: el CAP tiene que tener el formato del pais (5 cifras en Italia y Francia, 4 en Suiza...).
//  2. Google: se ubica "calle, CAP ciudad, pais" y se compara el pais y el CAP que Google encuentra con los del texto. Si el texto no trae el pais, se
//     deduce del que encuentra Google (la direccion mas el CAP casi siempre lo dejan claro).
// Solo avisa y sugiere: no decide nada, quien revisa corrige. Si Google no esta disponible, queda "no verificado" sin molestar.
const nombrePais = (codigo, lang = "it") => {
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(codigo) ?? codigo;
  } catch {
    return codigo;
  }
};

// parsed: { calle, cap, ciudad, pais }. geocode: se puede cambiar (pruebas). Devuelve { pais, avisos, verificacion }.
export const verificarDestino = async ({ calle, cap, ciudad, pais }, { geocode = geocodeComponents } = {}) => {
  const avisos = [];
  const paisEfectivo = pais ?? "IT";

  // 1. Formato del CAP segun el pais.
  if (cap && capCoincideConPais(cap, paisEfectivo) === false) {
    avisos.push(
      pais
        ? `Il CAP ${cap} non ha il formato di ${nombrePais(pais)}: controlla paese e CAP.`
        : `Il CAP ${cap} non ha il formato italiano e il testo non indica il paese: controlla il paese.`
    );
  }

  // 2. Google: sin calle no hay direccion que ubicar.
  if (!calle) return { pais, avisos, verificacion: { estado: "sin_datos" } };
  const consulta = [calle, [cap, ciudad].filter(Boolean).join(" "), pais && pais !== "IT" ? nombrePais(pais, "en") : null].filter(Boolean).join(", ");
  let encontrada;
  try {
    encontrada = await geocode(consulta);
  } catch {
    return { pais, avisos, verificacion: { estado: "no_verificado" } };
  }
  if (!encontrada) return { pais, avisos, verificacion: { estado: "no_verificado" } };

  let paisFinal = pais;
  let revisar = false;
  if (encontrada.pais && PAISES.includes(encontrada.pais)) {
    if (!pais) {
      if (encontrada.pais !== "IT") {
        paisFinal = encontrada.pais;
        avisos.push(`Il paese non è nel testo: dedotto ${nombrePais(encontrada.pais)} dall'indirizzo e dal CAP trovati. Controllalo.`);
      }
    } else if (encontrada.pais !== pais) {
      revisar = true;
      avisos.push(`Il testo dice ${nombrePais(pais)}, ma l'indirizzo con quel CAP si trova in ${nombrePais(encontrada.pais)}: controlla paese e CAP.`);
    }
  }
  if (cap && encontrada.cap && normCap(cap) !== normCap(encontrada.cap)) {
    revisar = true;
    avisos.push(`Il CAP del testo è ${cap}, ma l'indirizzo trovato ha CAP ${encontrada.cap}: controlla.`);
  }
  if (avisos.some((a) => a.includes("formato"))) revisar = true;

  return {
    pais: paisFinal,
    avisos,
    verificacion: { estado: revisar ? "revisar" : "ok", encontrada: encontrada.formatted ?? null, paisGoogle: encontrada.pais ?? null, capGoogle: encontrada.cap ?? null },
  };
};
