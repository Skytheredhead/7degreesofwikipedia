import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ImageResponse } from 'next/og';

export const size = {
  width: 64,
  height: 64,
};

export const contentType = 'image/png';

const fontPath = path.join(process.cwd(), 'assets', 'fonts', 'Syne-800.ttf');

export default async function Icon() {
  const syne = await readFile(fontPath);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(180deg, #0a0b15 0%, #06070f 100%)',
          borderRadius: 14,
          color: '#f2f4ff',
          fontFamily: 'Syne',
          fontSize: 52,
          fontWeight: 800,
          lineHeight: 1,
          letterSpacing: '-0.08em',
          paddingBottom: 2,
          boxShadow: 'inset 0 0 0 1px rgba(215,220,255,0.18)',
        }}
      >
        7
      </div>
    ),
    {
      ...size,
      fonts: [
        {
          name: 'Syne',
          data: syne,
          style: 'normal',
          weight: 800,
        },
      ],
    }
  );
}
