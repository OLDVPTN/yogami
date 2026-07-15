export const REWARDS = [
  {
    id: 'badge-vip',
    name: 'Badge VIP Member',
    price: 300,
    description: 'Badge status untuk member aktif. Fulfillment manual oleh owner.'
  },
  {
    id: 'voucher-diskon',
    name: 'Voucher Diskon Layanan',
    price: 500,
    description: 'Voucher diskon internal. Nominal dan syarat bisa kamu atur manual.'
  },
  {
    id: 'prioritas-cs',
    name: 'Prioritas CS 1x',
    price: 750,
    description: 'Member masuk antrean prioritas satu kali. Cocok untuk komunitas/agency.'
  },
  {
    id: 'bonus-special',
    name: 'Bonus Spesial Member',
    price: 1000,
    description: 'Reward fleksibel. Bisa diganti dengan saldo, hadiah, atau benefit lain.'
  }
];

export function findReward(id = '') {
  const target = String(id).trim().toLowerCase();
  return REWARDS.find((reward) => reward.id.toLowerCase() === target);
}

export function rewardListText() {
  return REWARDS.map((reward, index) => {
    return `${index + 1}. *${reward.name}*\n   ID: \`${reward.id}\`\n   Harga: *${reward.price} poin*\n   ${reward.description}`;
  }).join('\n\n');
}
