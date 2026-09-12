import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** Endpoint works without a token; if one is sent anyway, request.user is filled in. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
