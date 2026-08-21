import { HttpException, Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 128 ||
      value.startsWith('legacy-report:') ||
      value.startsWith('sync:') ||
      [...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      })
    ) {
      throw new HttpException(
        {
          code: 'INVALID_REQUEST',
          message: 'Idempotency-Key is invalid.',
        },
        400,
      );
    }
    return value;
  }
}
