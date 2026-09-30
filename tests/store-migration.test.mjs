import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createEconomy} from '../server/economy.mjs';

for(const legacy of ['diamonds','without-recipient'])test(`store upgrades ${legacy} purchases without replaying credits`,async()=>{
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 const now=()=>Date.parse('2026-09-30T12:00:00Z'),options={now,canGift:()=>true,paypal:{createOrder:async()=>({id:'ORDER-legacy'})}};
 try{
  let economy=createEconomy(db,[],()=>true,[],options);
  const paid=economy.store.grant('alice',{sku:'pouch',reason:'Existing paid pack'});
  const pending=await economy.store.begin('alice',{sku:'handful',requestId:'legacy-request'});
  db.prepare('INSERT INTO store_events VALUES (?,?,?,?)').run('old-event','PAYMENT.CAPTURE.COMPLETED',paid.id,new Date(now()).toISOString());
  // Reconstruct the deployed pre-upgrade table, retaining real receipts and wallet history.
  db.exec(`CREATE TABLE legacy_purchases(id TEXT PRIMARY KEY,owner TEXT NOT NULL REFERENCES economy_wallets(owner),request_id TEXT,order_id TEXT UNIQUE,sku TEXT NOT NULL,${legacy==='diamonds'?"diamonds INTEGER NOT NULL CHECK(diamonds>0)":"asset TEXT NOT NULL CHECK(asset IN ('diamonds','coins')),amount INTEGER NOT NULL CHECK(amount>0)"},price_cents INTEGER NOT NULL CHECK(price_cents>=0),currency TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','fulfilled','refunded','disputed','failed','cancelled')),capture_id TEXT,payer_id TEXT,clawback_short INTEGER NOT NULL DEFAULT 0,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
   INSERT INTO legacy_purchases SELECT id,owner,request_id,order_id,sku,${legacy==='diamonds'?'amount':'asset,amount'},price_cents,currency,status,capture_id,payer_id,clawback_short,note,created_at,updated_at FROM store_purchases;
   DROP TABLE store_purchases;ALTER TABLE legacy_purchases RENAME TO store_purchases;
   CREATE UNIQUE INDEX store_purchase_request ON store_purchases(owner,request_id) WHERE request_id IS NOT NULL;`);
  const before=db.prepare('SELECT * FROM store_purchases ORDER BY id').all();
  const wallet=economy.snapshot('alice').wallet,history=economy.snapshot('alice').history,until=economy.store.supporterUntil('alice');
  const schema=db.prepare('PRAGMA table_info(store_purchases)').all(),exec=db.exec.bind(db);
  db.exec=sql=>{if(sql.includes('CREATE INDEX IF NOT EXISTS store_purchase_owner'))throw Error('Simulated upgrade failure');return exec(sql);}; // Fail after copying the old rows to check the entire schema change rolls back.
  assert.throws(()=>createEconomy(db,[],()=>true,[],options),/Simulated upgrade failure/);db.exec=exec;
  assert.deepEqual(db.prepare('PRAGMA table_info(store_purchases)').all(),schema);
  assert.deepEqual(db.prepare('SELECT * FROM store_purchases ORDER BY id').all(),before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='store_purchases_upgrade'").get().n,0);
  economy=createEconomy(db,[],()=>true,[],options); // Existing installations must open as successfully as an empty database.
  const expected=before.map(row=>{const {diamonds,...rest}=row;return {...rest,recipient:null,...(legacy==='diamonds'?{asset:'diamonds',amount:diamonds}:{})};});
  assert.deepEqual(db.prepare('SELECT * FROM store_purchases ORDER BY id').all().map(row=>({...row})),expected);
  assert.deepEqual(economy.snapshot('alice').wallet,wallet);assert.deepEqual(economy.snapshot('alice').history,history);
  assert.equal(economy.store.supporterUntil('alice'),until);assert.equal(db.prepare('SELECT COUNT(*) n FROM store_events').get().n,1);
  assert.equal(economy.store.view('alice').purchases.length,2);
  assert.equal((await economy.store.begin('alice',{sku:'handful',requestId:'legacy-request'})).id,pending.id);
  economy.store.fulfil(paid.id);assert.equal(economy.snapshot('alice').wallet.diamonds,15,'fulfilled receipts never credit twice');
  economy.store.fulfil(pending.id);assert.equal(economy.snapshot('alice').wallet.diamonds,20,'old pending orders can still complete');
  await economy.store.refund({id:paid.id,reason:'Refund original pack'});assert.equal(economy.snapshot('alice').wallet.diamonds,5);
  economy.store.grant('alice',{sku:'purse',reason:'New coin pack'});assert.equal(economy.snapshot('alice').wallet.coins,1000);
  options.paypal.createOrder=async()=>({id:'ORDER-gift'});
  const gift=await economy.store.begin('alice',{sku:'purse',requestId:'new-gift-request',recipient:'bob'});
  economy.store.fulfil(gift.id);assert.equal(economy.snapshot('bob').wallet.coins,1000);
  const rows=db.prepare('SELECT * FROM store_purchases ORDER BY id').all(),ledger=db.prepare('SELECT * FROM economy_ledger ORDER BY id').all();
  createEconomy(db,[],()=>true,[],options); // Repeated startups must leave receipts and every ledger entry untouched.
  assert.deepEqual(db.prepare('SELECT * FROM store_purchases ORDER BY id').all(),rows);
  assert.deepEqual(db.prepare('SELECT * FROM economy_ledger ORDER BY id').all(),ledger);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 }finally{db.close();}
});
