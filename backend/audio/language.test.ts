import { expect, test } from "bun:test";
import { guessLanguage, languageName, normalizeLanguageCode } from "./language";

test("language codes are ISO 639 codes or BCP 47 tags, reported by their English names", () => {
  expect(normalizeLanguageCode("en")).toBe("en");
  expect(normalizeLanguageCode("DE")).toBe("de");
  expect(normalizeLanguageCode("pt-BR")).toBe("pt");
  expect(normalizeLanguageCode("sv_SE")).toBe("sv");
  expect(normalizeLanguageCode("english")).toBeUndefined();
  expect(normalizeLanguageCode("zz")).toBeUndefined();
  expect(normalizeLanguageCode("e")).toBeUndefined();
  expect(languageName("sv")).toBe("Swedish");
});

test("a transcript's language is guessed from its common words, or left unknown", () => {
  expect(guessLanguage("Welcome to the weekly product update. Today we are going to talk about three things.")).toBe("en");
  expect(guessLanguage("Guten Morgen und willkommen zur Besprechung. Heute sprechen wir über das neue Abrechnungssystem, und die Kunden können online bezahlen.")).toBe("de");
  expect(guessLanguage("Hej och välkommen till veckans möte. Idag ska vi prata om den nya faktureringen och det är bra.")).toBe("sv");
  expect(guessLanguage("Bonjour et bienvenue. Nous allons parler de la nouvelle facture et des paiements pour les clients.")).toBe("fr");
  expect(guessLanguage("नमस्ते और स्वागत है")).toBe("hi");
  expect(guessLanguage("Okay.")).toBeUndefined();
  expect(guessLanguage("Kubernetes Ingress Traefik Cloudflare Tunnel")).toBeUndefined();
});
