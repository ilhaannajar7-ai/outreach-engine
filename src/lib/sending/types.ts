export interface DnsCheckResult {
  status: 'pass' | 'fail' | 'missing' | 'unknown';
  message: string;
  record: string | null;
  selector?: string;
}
