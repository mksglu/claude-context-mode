import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { PrismaClient, Prisma } from "@prisma/client";
import { logger } from "../utils/logger";
import { AppError, NotFoundError, ValidationError } from "../errors";

// Types
interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

interface UserWithProfile extends User {
  profile: {
    bio: string | null;
    avatarUrl: string | null;
    timezone: string;
  };
}

type UserRole = "admin" | "moderator" | "user" | "viewer";

interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// Validation schemas
const CreateUserSchema = z.object({
  email: z.string().email("Invalid email address"),
  name: z.string().min(2, "Name must be at least 2 characters").max(100),
  role: z.enum(["admin", "moderator", "user", "viewer"]).default("user"),
  profile: z
    .object({
      bio: z.string().max(500).optional(),
      avatarUrl: z.string().url().optional(),
      timezone: z.string().default("UTC"),
    })
    .optional(),
});

const UpdateUserSchema = CreateUserSchema.partial().omit({ email: true });

const ListUsersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(["admin", "moderator", "user", "viewer"]).optional(),
  search: z.string().optional(),
  sortBy: z.enum(["name", "createdAt", "email"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

type CreateUserInput = z.infer<typeof CreateUserSchema>;
type UpdateUserInput = z.infer<typeof UpdateUserSchema>;

// Service
export class UserService {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<UserWithProfile> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { profile: true },
    });

    if (!user) {
      throw new NotFoundError(`User with id ${id} not found`);
    }

    return user as UserWithProfile;
  }

  async list(params: z.infer<typeof ListUsersQuerySchema>): Promise<PaginatedResponse<User>> {
    const { page, pageSize, role, search, sortBy, sortOrder } = params;
    const skip = (page - 1) * pageSize;

    const where: Prisma.UserWhereInput = {
      ...(role && { role }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: "insensitive" as const } },
          { email: { contains: search, mode: "insensitive" as const } },
        ],
      }),
    };

    const [users, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        skip,
        take: pageSize,
        orderBy: { [sortBy]: sortOrder },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users as User[],
      total,
      page,
      pageSize,
      hasMore: skip + pageSize < total,
    };
  }

  async create(input: CreateUserInput): Promise<User> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new ValidationError("A user with this email already exists");
    }

    return this.prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        role: input.role,
        profile: input.profile ? { create: input.profile } : undefined,
      },
      include: { profile: true },
    }) as Promise<User>;
  }

  async update(id: string, input: UpdateUserInput): Promise<User> {
    await this.findById(id);
    return this.prisma.user.update({
      where: { id },
      data: {
        ...input,
        profile: input.profile ? { update: input.profile } : undefined,
        updatedAt: new Date(),
      },
    }) as Promise<User>;
  }

  async delete(id: string): Promise<void> {
    await this.findById(id);
    await this.prisma.user.delete({ where: { id } });
  }
}

// Route setup
export function setupRoutes(router: Router, service: UserService): Router {
  router.get("/users", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const query = ListUsersQuerySchema.parse(req.query);
      const result = await service.list(query);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.get("/users/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await service.findById(req.params.id);
      res.json(user);
    } catch (error) {
      next(error);
    }
  });

  router.post("/users", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = CreateUserSchema.parse(req.body);
      const user = await service.create(input);
      res.status(201).json(user);
    } catch (error) {
      next(error);
    }
  });

  router.patch("/users/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = UpdateUserSchema.parse(req.body);
      const user = await service.update(req.params.id, input);
      res.json(user);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/users/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      await service.delete(req.params.id);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
