// Jalankan di terminal EasyPanel:
// node scripts/set-owner.js rizkyzaneva@gmail.com
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];
  if (!email) {
    console.error('Usage: node scripts/set-owner.js <email>');
    process.exit(1);
  }

  const user = await prisma.user.update({
    where: { email },
    data: { platformRole: 'owner' }
  });

  console.log(`✅ ${user.name} (${user.email}) sekarang menjadi Owner`);
}

main()
  .catch(e => { console.error('❌', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
