import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const email = process.env.ADMIN_EMAIL ?? 'admin@reelstudio.app'

await prisma.user.upsert({
  where: { email },
  update: { name: 'Studio Admin', role: 'admin' },
  create: { email, name: 'Studio Admin', role: 'admin' },
})

const existing = await prisma.content.findFirst({ where: { title: 'Welcome draft' } })
if (!existing) {
  await prisma.content.create({
    data: {
      title: 'Welcome draft',
      caption: 'A local draft so the content table has a row before any account is connected.',
      hashtags: '#studio',
      format: 'instagram_reel',
      status: 'draft',
      timezone: 'Asia/Kolkata',
    },
  })
}

await prisma.$disconnect()
