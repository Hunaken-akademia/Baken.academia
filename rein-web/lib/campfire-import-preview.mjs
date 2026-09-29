/** Only the authenticated administrator receives these rows.
 * @returns {Array<{rowNumber: number, memberKey: string, name: string|null, email: string, plan: string, status: string, action: string, accessEndsAt: string|null, emailStatus: string}>}
 */
export function buildImportRows(members, records, existing, outbox) {
  const byEmail = new Map(records.map(row => [row.google_email, row]));
  const existingKeys = new Set(existing.map(row => row.member_key));
  const mailByKey = new Map(outbox.map(row => [row.member_key, row]));
  return members.map(member => {
    const record = byEmail.get(member.google_email);
    const mail = record ? mailByKey.get(record.member_key) : null;
    return {
      rowNumber: member.row_number,
      memberKey: record?.member_key || member.member_key,
      name: member.member_name,
      email: member.google_email,
      plan: member.plan,
      status: member.status,
      action: !record ? "protected" : existingKeys.has(record.member_key) ? "update" : "new",
      accessEndsAt: record?.access_ends_at || null,
      emailStatus: !record || member.status !== "active" ? "not_applicable" : mail?.status || "pending",
    };
  });
}
