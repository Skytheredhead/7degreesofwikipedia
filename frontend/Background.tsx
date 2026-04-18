// components/Background.tsx
'use client';
import { memo, useEffect, useRef } from 'react';

const Background = memo(function Background() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) {
      return;
    }

    type Particle = {
      x: number;
      y: number;
      radius: number;
      opacity: number;
    };

    let resizeTimer: number | undefined;

    const draw = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.ceil(width * dpr);
      canvas.height = Math.ceil(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.fillStyle = '#060810';
      context.fillRect(0, 0, width, height);

      const particleCount = Math.min(150, Math.max(70, Math.round((width * height) / 9000)));
      const particles: Particle[] = Array.from({ length: particleCount }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        radius: Math.random() * 1.2 + 0.25,
        opacity: Math.random() * 0.38 + 0.12,
      }));

      for (const particle of particles) {
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fillStyle = `rgba(200,205,230,${particle.opacity})`;
        context.fill();
      }
    };

    const handleResize = () => {
      if (resizeTimer !== undefined) {
        window.clearTimeout(resizeTimer);
      }
      resizeTimer = window.setTimeout(draw, 120);
    };

    draw();
    window.addEventListener('resize', handleResize);

    return () => {
      if (resizeTimer !== undefined) {
        window.clearTimeout(resizeTimer);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, zIndex: 0 }} />;
});

export default Background;
