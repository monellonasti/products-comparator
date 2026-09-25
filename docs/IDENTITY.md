# Identità prodotto, EAN e accorpamento

Il sistema separa l'**identità del prodotto** (`products` + `product_identifiers`) dall'**offerta commerciale** di un fornitore (`supplier_offers`). Una scheda (card) corrisponde a un prodotto canonico; le offerte dei fornitori restano distinte.

## Codici a barre (src/lib/gtin.ts)

| Regola | Comportamento |
|---|---|
| Conservazione | Il valore originale è sempre salvato come stringa (`supplier_offers.barcode_raw`), con eventuali zeri iniziali. |
| Formati | EAN-8 (GTIN-8), UPC-A (GTIN-12), EAN-13 (GTIN-13), GTIN-14. Si verifica la cifra di controllo GS1 (mod 10). |
| Normalizzazione | Forma canonica = **GTIN-14** con zeri a sinistra. Per GS1 è una rappresentazione equivalente dello stesso GTIN: l'UPC-A `036000291452` e l'EAN-13 `0036000291452` coincidono. |
| Confezioni | Un GTIN-14 con indicatore 1-8 (cartone/multipack) produce un valore canonico **diverso** dal GTIN-13 del pezzo singolo: non vengono mai equiparati. |
| Nessuna correzione | Cifra di controllo errata, lunghezza non supportata (es. 11 cifre per zeri persi), lettere, decimali (`…0`), notazione scientifica (`8,00123E+12`) → `invalid` con motivo esplicito. Nessun padding o ricostruzione. |
| Formattazione | Spazi o trattini **tra gruppi di cifre** vengono ignorati con avviso (`barcode_formatting`). |
| Circolazione limitata | Prefissi 020-029, 040-049, 050-059, 200-299 (in-store/interni/coupon), 980-984, 990-999 e RCN-8 (0xxx, 2xxx): `restricted`. Validi, ma **mai** usati per accorpare fornitori diversi. |
| Assente | Cella vuota o marcatore (`-`, `n/d`…) → `missing`. Due valori assenti non costituiscono una corrispondenza (caso C). |
| UPC-E da foto | Solo per codici letti da immagine con simbologia UPC-E si applica l'espansione standard a UPC-A. |

## Regole di accorpamento durante l'import (src/imports/apply.ts)

1. **Offerta già nota (stesso fornitore e SKU) con lo stesso GTIN**: resta sul suo prodotto, anche se era stata collegata manualmente.
2. **GTIN valido nuovo per l'offerta**:
   - se nessun prodotto possiede quel GTIN, si crea il prodotto e la riga `product_identifiers` (vincolo `UNIQUE(kind, value)`);
   - se esiste, si confrontano gli **attributi d'identità**: marca normalizzata ("LELO Inc." = "Lelo"), colore, misura, variante, contenuto netto, pezzi per articolo. Il titolo **non** conta (caso A: titoli diversi, stessa scheda);
   - se c'è conflitto, l'offerta va in un prodotto separato con `link_source = 'conflict_hold'` e si apre una revisione `gtin_conflict`. I dati del prodotto esistente non vengono sovrascritti.
3. **GTIN assente, non valido o a circolazione limitata**: prodotto distinto (`standalone`). Dopo l'import il job `suggest_matches` propone possibili doppioni (similarità dei titoli ≥ 0,6 con pg_trgm, marca compatibile, stessa immagine come indizio debole). Sono solo **revisioni**, mai fusioni.
4. **EAN corretto dal fornitore** (lo SKU resta uguale, il GTIN cambia): l'offerta viene spostata sul prodotto del nuovo GTIN. Il prodotto di prima, se resta senza offerte, passa ad `archived`. L'evento viene registrato (`offer.relinked`). Se il collegamento precedente era manuale si apre anche una revisione `gtin_changed`.
5. **SKU**: univoco per fornitore (`UNIQUE(supplier_id, supplier_sku)`), non a livello globale. Lo stesso SKU presso due fornitori con EAN diversi dà due prodotti (caso B).

**Concorrenza**: ogni batch acquisisce `pg_advisory_xact_lock` sui GTIN che contiene, in ordine crescente (niente deadlock da ordine dei lock). Il vincolo unico su `product_identifiers` resta la garanzia finale: se un'altra transazione ha già creato il prodotto, si usa il suo. Il test `tests/integration/imports.test.ts › concurrency` avvia 4 import in parallelo con gli stessi GTIN e verifica che nasca un solo prodotto per GTIN.

## Dati canonici (src/domain/canonical.ts)

Titolo, marca, categoria, attributi e immagine principale vengono ricalcolati nella stessa transazione della modifica, con questa precedenza deterministica:

`override manuale` → `fornitore con priority più bassa` → `offerta attiva` → `dato più recente (source_as_of)` → `offerta più vecchia` → `id`

Gli override (`title_override`, `brand_override`, `category_override_id`, `primary_image_override_id`) non vengono mai toccati dagli import. `canonical_sources` registra da quale offerta proviene ogni campo, e la scheda lo mostra ("da Alfa Distribuzione").

## Operazioni manuali reversibili (src/domain/associations.ts)

| Operazione | Cosa registra l'audit | Annullamento |
|---|---|---|
| Unione (`product.merge`) | offerte spostate con il loro `link_source` precedente e identificativi spostati | `product.split`: riporta offerte e identificativi. Riporta anche le offerte arrivate **dopo** l'unione tramite un GTIN spostato (caso J) |
| Separazione di un'offerta (`offer.detach`) | prodotto di origine e di destinazione, `link_source` precedente | `offer.reattach` |
| Override manuale (`product.override`) | valori prima e dopo | ripristino dei valori precedenti |
| "Prodotti diversi" in revisione | coppia in `product_distinct_pairs` | la coppia non viene più riproposta |

Per unire prodotti con **EAN diversi** serve una motivazione di almeno 10 caratteri con le evidenze. La somiglianza visiva non basta mai: una foto identica può essere riutilizzata per varianti diverse (caso D).
