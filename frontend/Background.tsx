// components/Background.tsx
'use client';
import { memo, useEffect, useRef } from 'react';

const Background = memo(function Background() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };

    resize();
    window.addEventListener('resize', resize);

    type Particle = {
      x: number;
      y: number;
      radius: number;
      velocityX: number;
      velocityY: number;
      opacity: number;
      phase: number;
    };

    const particles: Particle[] = Array.from({ length: 180 }, () => ({
      x: Math.random() * window.innerWidth,
      y: Math.random() * window.innerHeight,
      radius: Math.random() * 1.25 + 0.3,
      velocityX: (Math.random() - 0.5) * 0.12,
      velocityY: (Math.random() - 0.5) * 0.08,
      opacity: Math.random() * 0.5 + 0.1,
      phase: Math.random() * Math.PI * 2,
    }));

    let time = 0;
    const draw = () => {
      time += 0.008;
      context.fillStyle = '#060810';
      context.fillRect(0, 0, canvas.width, canvas.height);

      for (const particle of particles) {
        particle.x += particle.velocityX;
        particle.y += particle.velocityY;

        if (particle.x < 0) particle.x = canvas.width;
        if (particle.x > canvas.width) particle.x = 0;
        if (particle.y < 0) particle.y = canvas.height;
        if (particle.y > canvas.height) particle.y = 0;

        const twinkle = particle.opacity * (0.7 + 0.3 * Math.sin(time * 0.8 + particle.phase));
        context.beginPath();
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fillStyle = `rgba(200,205,230,${twinkle})`;
        context.fill();
      }

      animationRef.current = requestAnimationFrame(draw);
    };

    animationRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationRef.current);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: 'fixed', inset: 0, zIndex: 0 }} />;
});

export default Background;
