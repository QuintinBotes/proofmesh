export const greet = (name: string): string => `hello ${name}`;

export const shout = function (text: string): string {
  return text + "!";
};

export const limit = 3;

greet("module");
