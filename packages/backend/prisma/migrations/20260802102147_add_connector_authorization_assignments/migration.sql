-- CreateEnum
CREATE TYPE "ConnectorAuthMode" AS ENUM ('SHARED', 'PER_USER');

-- CreateEnum
CREATE TYPE "UserConnectorAuthorizationStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'REVOKED', 'ERROR');

-- DropIndex
DROP INDEX "users_onboarding_drip_idx";

-- AlterTable
ALTER TABLE "connectors" ADD COLUMN     "auth_mode" "ConnectorAuthMode" NOT NULL DEFAULT 'SHARED';

-- CreateTable
CREATE TABLE "connector_authorization_assignments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "user_id" TEXT,
    "role_id" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_authorization_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_connector_authorizations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "connector_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "UserConnectorAuthorizationStatus" NOT NULL DEFAULT 'PENDING',
    "credential" TEXT,
    "last_error" TEXT,
    "authorized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_connector_authorizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connector_authorization_assignments_organization_id_idx" ON "connector_authorization_assignments"("organization_id");

-- CreateIndex
CREATE INDEX "connector_authorization_assignments_user_id_idx" ON "connector_authorization_assignments"("user_id");

-- CreateIndex
CREATE INDEX "connector_authorization_assignments_role_id_idx" ON "connector_authorization_assignments"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_authorization_assignments_connector_id_user_id_key" ON "connector_authorization_assignments"("connector_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "connector_authorization_assignments_connector_id_role_id_key" ON "connector_authorization_assignments"("connector_id", "role_id");

-- CreateIndex
CREATE INDEX "user_connector_authorizations_organization_id_idx" ON "user_connector_authorizations"("organization_id");

-- CreateIndex
CREATE INDEX "user_connector_authorizations_user_id_idx" ON "user_connector_authorizations"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_connector_authorizations_connector_id_user_id_key" ON "user_connector_authorizations"("connector_id", "user_id");

-- AddForeignKey
ALTER TABLE "connector_authorization_assignments" ADD CONSTRAINT "connector_authorization_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_authorization_assignments" ADD CONSTRAINT "connector_authorization_assignments_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_authorization_assignments" ADD CONSTRAINT "connector_authorization_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_authorization_assignments" ADD CONSTRAINT "connector_authorization_assignments_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_connector_authorizations" ADD CONSTRAINT "user_connector_authorizations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_connector_authorizations" ADD CONSTRAINT "user_connector_authorizations_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_connector_authorizations" ADD CONSTRAINT "user_connector_authorizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
