export function nowUtc(): Date {
  return new Date();
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600 * 1000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400 * 1000);
}

export function isPast(date: Date): boolean {
  return date < new Date();
}
