interface AnomalyBadgeProps {
  status: 'healthy' | 'price-hiked' | 'unused' | 'duplicate' | 'trial';
}

const labels = {
  healthy: 'Healthy',
  'price-hiked': 'Price increased',
  unused: 'Low usage',
  duplicate: 'Possible duplicate',
  trial: 'Trial ending',
};

const styles = {
  healthy: 'border-[#cde0d3] bg-[#f0f7f2] text-[#176b4b]',
  'price-hiked': 'border-[#efd3d0] bg-[#fdf4f3] text-[#a53630]',
  unused: 'border-[#e1e4df] bg-[#f5f6f3] text-[#647169]',
  duplicate: 'border-[#e4ded0] bg-[#faf7ef] text-[#766136]',
  trial: 'border-[#ecdbae] bg-[#fff9e8] text-[#8a5a00]',
};

export function AnomalyBadge({ status }: AnomalyBadgeProps) {
  return <span className={`inline-flex shrink-0 rounded-md border px-2 py-1 text-[10px] font-semibold ${styles[status]}`}>{labels[status]}</span>;
}

export default AnomalyBadge;
