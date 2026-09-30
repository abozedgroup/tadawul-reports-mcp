#!/usr/bin/env node
import { Store, openDb } from "./db.js";
import { importFromFile, loadBundledData, seedCompanies } from "./data.js";

const [command, file] = process.argv.slice(2);
const store = new Store(openDb());

if (command === "seed") {
  console.log(`أُضيفت أو حُدّثت ${seedCompanies(store, file)} شركة.`);
} else if (command === "load") {
  const n = loadBundledData(store);
  console.log(`حُمّلت ${n.companies} شركة و${n.reports} تقرير من مجلد data.`);
} else if (command === "import" && file) {
  const n = importFromFile(store, file);
  console.log(`استُورد ${n.companies} شركة و${n.reports} تقرير.`);
} else {
  console.error(
    "الاستخدام:\n  tadawul-cli seed [companies.json]\n  tadawul-cli load\n  tadawul-cli import <file.json>",
  );
  process.exit(1);
}
