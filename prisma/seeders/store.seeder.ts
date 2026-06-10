import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Missing DATABASE_URL in environment.');
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: DATABASE_URL })),
});

// IDs are pinned so the seed is deterministic. The queue-display frontend targets
// a fixed Store id, so a reseed/redeploy must NOT hand it a new random UUID.
const stores = [
  {
    id:        '67ecc9c9-1b91-4308-b345-6977836412a1',
    name:      'Muji Estancia',
    storeCode: 'MUJI-EST-001',
    location:  'MUJI Glorietta 3 Unit G3-139, Glorietta 3 (GFl-3F), Ayala Malls Glorietta, Parkway Dr, Makati City',
  },
  {
    id:        'b7e6d5c4-3a2b-41c0-9d8e-1f2a3b4c5d6e',
    name:      'Muji SM Aura',
    storeCode: 'MUJI-AUR-001',
    location:  '3rd Floor of SM Aura Premier, 26th Street Corner McKinley Parkway, Bonifacio Global City (BGC), Taguig City, Metro Manila',
  },
];

async function main() {
  for (const store of stores) {
    const { storeCode, ...rest } = store;

    // Upsert keyed by the unique storeCode; the update path also repairs a drifted
    // id (FK is ON UPDATE CASCADE), so re-running heals a DB seeded before IDs were pinned.
    const result = await prisma.store.upsert({
      where:  { storeCode },
      create: store,
      update: rest,
    });
    console.log(`Store seeded: ${result.name} (${result.storeCode}) id=${result.id}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
