export function nowUtc(): Date {
  return new Date();
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function isPast(date: Date): boolean {
  return date < new Date();
}
