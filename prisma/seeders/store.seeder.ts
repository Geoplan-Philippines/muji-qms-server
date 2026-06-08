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

const stores = [
  {
    name:      'Muji Estancia',
    storeCode: 'MUJI-EST-001',
    location:  'MUJI Glorietta 3 Unit G3-139, Glorietta 3 (GFl-3F), Ayala Malls Glorietta, Parkway Dr, Makati City',
  },
  {
    name:      'Muji SM Aura',
    storeCode: 'MUJI-AUR-001',
    location:  '3rd Floor of SM Aura Premier, 26th Street Corner McKinley Parkway, Bonifacio Global City (BGC), Taguig City, Metro Manila',
  },
];

async function main() {
  for (const store of stores) {
    const existing = await prisma.store.findUnique({ where: { storeCode: store.storeCode } });

    if (existing) {
      console.log(`Store already exists: ${existing.name} (${existing.storeCode}). Skipping.`);
      continue;
    }

    const created = await prisma.store.create({ data: store });
    console.log(`Store created: ${created.name} (${created.storeCode})`);
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
