const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const User = require('../models/User');
const Contract = require('../models/Contract');
const Obligation = require('../models/Obligation');
const Milestone = require('../models/Milestone');
const Approval = require('../models/Approval');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const seed = async () => {
  try {
    // autoIndex is disabled so seeding can never implicitly build the unique
    // (contract, version) document index. That index is created only by the
    // explicit "npm run indexes:sync" procedure.
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ricozcontract', {
      autoIndex: false
    });

    const existingUsers = await User.countDocuments();
    if (existingUsers > 0 && process.env.FORCE_SEED !== 'true') {
      console.log('Database already has users. Skipping seed to avoid wiping data.');
      console.log('Set FORCE_SEED=true to replace demo data.');
      process.exit(0);
    }

    await User.deleteMany();
    await Contract.deleteMany();
    await Obligation.deleteMany();
    await Milestone.deleteMany();
    await Approval.deleteMany();

    const admin = await User.create({
      name: 'Admin User',
      email: 'admin@ricoz.com',
      password: 'password123',
      role: 'Admin',
      department: 'Legal'
    });

    const manager = await User.create({
      name: 'Legal Manager',
      email: 'manager@ricoz.com',
      password: 'password123',
      role: 'Manager',
      department: 'Compliance'
    });

    const employee = await User.create({
      name: 'Procurement Specialist',
      email: 'employee@ricoz.com',
      password: 'password123',
      role: 'Employee',
      department: 'Procurement'
    });

    const contract1 = await Contract.create({
      contractNumber: 'CNT-2026-0001',
      title: 'Enterprise Cloud SaaS Service Agreement',
      type: 'Vendor',
      partyName: 'AWS Services LLC',
      description: 'Annual infrastructure hosting commitment.',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
      amount: 120000,
      currency: 'USD',
      createdBy: employee._id,
      assignedUser: manager._id,
      status: 'Active'
    });

    const contract2 = await Contract.create({
      contractNumber: 'CNT-2026-0002',
      title: 'Professional Services NDA',
      type: 'NDA',
      partyName: 'Northwind Partners',
      description: 'Mutual confidentiality for upcoming implementation work.',
      startDate: new Date(),
      endDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
      amount: 0,
      currency: 'USD',
      createdBy: manager._id,
      assignedUser: employee._id,
      status: 'Pending Approval'
    });

    await Obligation.create({
      contract: contract1._id,
      title: 'Submit SOC2 Compliance Audit Document',
      description: 'Vendor must upload quarterly security report',
      assignedTo: employee._id,
      dueDate: new Date('2026-06-30'),
      status: 'Pending'
    });

    await Milestone.create({
      contract: contract1._id,
      title: 'Kickoff and access provisioning',
      description: 'Complete onboarding checklist with the vendor.',
      assignedTo: employee._id,
      dueDate: new Date('2026-03-15'),
      status: 'In Progress'
    });

    await Approval.create({
      contract: contract2._id,
      requestedBy: manager._id,
      status: 'Pending'
    });

    console.log('✅ Demo Data Successfully Seeded!');
    console.log('Admin Login: admin@ricoz.com / password123');
    console.log('Manager Login: manager@ricoz.com / password123');
    console.log('Employee Login: employee@ricoz.com / password123');
    process.exit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

seed();
