"use client";

export function SupplierChat({ supplierName }: { supplierName: string }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <h3 className="mb-2 font-medium">{supplierName}</h3>
      <p className="text-sm text-gray-500">No messages yet.</p>
    </div>
  );
}
