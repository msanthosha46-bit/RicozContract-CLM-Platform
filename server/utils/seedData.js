const mongoose = require('mongoose');
const dotenv = require('dotenv');
const path = require('path');
const User = require('../models/User');
const Contract = require('../models/Contract');
const Obligation = require('../models/Obligation');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/ricozcontract');
    await User.deleteMany();
    await Contract.deleteMany();
    await Obligation.deleteMany();

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

    await Obligation.create({
      contract: contract1._id,
      title: 'Submit SOC2 Compliance Audit Document',
      description: 'Vendor must upload quarterly security report',
      assignedTo: employee._id,
      dueDate: new Date('2026-06-30'),
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