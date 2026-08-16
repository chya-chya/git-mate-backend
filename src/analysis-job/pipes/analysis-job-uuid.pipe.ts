import { HttpException, Injectable, PipeTransform } from '@nestjs/common';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class AnalysisJobUuidPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new HttpException(
        { code: 'INVALID_REQUEST', message: 'Job ID must be a valid UUID.' },
        400,
      );
    }
    return value;
  }
}
