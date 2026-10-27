import { openDb, createSprint, updateSprint } from "../../src/index";
const [path,operation,ref,payload] = Bun.argv.slice(2);
const db = openDb(path!);
try {
  const ctx = {db,actor:"me"};
  const value = operation === "create" ? createSprint(ctx,JSON.parse(payload!)) : updateSprint(ctx,ref!,JSON.parse(payload!));
  process.stdout.write(JSON.stringify({value}));
} catch (e) { process.stdout.write(JSON.stringify({error:{code:(e as {code?:string}).code}})); }
finally { db.close(); }
